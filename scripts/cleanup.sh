#!/bin/bash
# Tear down the Boltz attestation stack, working around the CodeBuild fleet.
# Usage: ./scripts/cleanup.sh [stack-name]
#
# WHY THIS SCRIPT EXISTS
#   The stack contains a CodeBuild reserved-capacity fleet (LINUX_EC2). When
#   CloudFormation deletes a fleet it triggers PENDING_DELETION and then waits
#   for the fleet to drain — but a fleet can sit in PENDING_DELETION for up to
#   ~1 hour, which is longer than CloudFormation's stabilization window. So a
#   plain `cdk destroy` / delete-stack fails the fleet with:
#       "Exceeded attempts to wait" (NotStabilized)
#   and leaves the whole stack in DELETE_FAILED. There is no CDK/CloudFormation
#   knob to extend that wait, so the only reliable path today is:
#     1. delete the stack while RETAINING the fleet, then
#     2. delete the fleet on its own (it drains in the background, out of band).
#
# This script does exactly that.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Args: [stack-name] and an optional --purge-artifacts (alias --full) flag that,
# after the stack is deleted, also removes the OUT-OF-BAND artifacts CloudFormation
# never tracked: the attested AMIs + their EBS snapshots (registered by CodeBuild)
# and the runtime-written /boltz/models/* SSM parameters. Use it for a true
# deploy-from-scratch. Without the flag, only the stack (and its fleet) is removed.
PURGE_ARTIFACTS=0
STACK_NAME="${STACK_NAME:-BoltzAttestationStack}"
for arg in "$@"; do
    case "$arg" in
        --purge-artifacts|--full) PURGE_ARTIFACTS=1 ;;
        --*) echo "Unknown flag: $arg" >&2; exit 2 ;;
        *) STACK_NAME="$arg" ;;
    esac
done

# All artifacts are region-scoped, so pin the region for every call below. Prefer an
# explicit AWS_REGION/AWS_DEFAULT_REGION, else fall back to the CLI-configured region.
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
if [ -z "$REGION" ]; then
    echo "ERROR: no region resolved. Set AWS_REGION (e.g. AWS_REGION=us-east-2 $0 ...)." >&2
    exit 2
fi
export AWS_DEFAULT_REGION="$REGION"

# Only ever touch AMIs with this exact name prefix (the value of <image name=...> in
# kiwi/config.xml). This is what keeps the purge from deleting unrelated AMIs that
# may co-exist in a shared account.
AMI_NAME_PREFIX="boltz-protein-folding-attestable"

echo "==> Cleaning up stack: $STACK_NAME (region: $REGION, purge-artifacts: $PURGE_ARTIFACTS)"

# ---- Resolve the fleet ARN (prefer cdk-outputs.json, else discover) -----------
# The fleet is CDK auto-named (no fixed name), but the stack now exports its ARN as
# the CodeBuildFleetArn output, so a deploy captures it in cdk-outputs.json. Prefer
# that; fall back to reading it from the live stack, then to a name-prefix match.
OUTPUTS_FILE="$PROJECT_ROOT/cdk/cdk-outputs.json"
FLEET_ARN=""
if [ -f "$OUTPUTS_FILE" ]; then
    FLEET_ARN="$(python3 -c "import json;print(json.load(open('$OUTPUTS_FILE')).get('$STACK_NAME',{}).get('CodeBuildFleetArn',''))" 2>/dev/null || true)"
    [ -n "$FLEET_ARN" ] && echo "==> Fleet ARN from cdk-outputs.json: $FLEET_ARN"
fi

# The logical id is needed for --retain-resources, so resolve it from the live stack.
FLEET_LOGICAL_ID="$(aws cloudformation list-stack-resources \
    --stack-name "$STACK_NAME" \
    --query "StackResourceSummaries[?ResourceType=='AWS::CodeBuild::Fleet'].LogicalResourceId | [0]" \
    --output text 2>/dev/null || true)"
if { [ -z "$FLEET_ARN" ] || [ "$FLEET_ARN" = "None" ]; } && \
   [ -n "$FLEET_LOGICAL_ID" ] && [ "$FLEET_LOGICAL_ID" != "None" ]; then
    FLEET_ARN="$(aws cloudformation describe-stack-resource \
        --stack-name "$STACK_NAME" \
        --logical-resource-id "$FLEET_LOGICAL_ID" \
        --query "StackResourceDetail.PhysicalResourceId" \
        --output text 2>/dev/null || true)"
fi
if [ -z "$FLEET_ARN" ] || [ "$FLEET_ARN" = "None" ]; then
    FLEET_ARN="$(aws codebuild list-fleets \
        --query "fleets[?contains(@, 'AmiBuilderFleet')] | [0]" --output text 2>/dev/null || true)"
fi

# ---- Delete the fleet UP FRONT so it drains in parallel -----------------------
# A CodeBuild fleet can sit in PENDING_DELETION for ~1 hour. If CloudFormation
# deletes it inline, the stack delete stalls past its stabilization window and lands
# in DELETE_FAILED. Kicking off the fleet delete now means it is already draining
# (often gone within minutes when idle) by the time CloudFormation reaches it, so the
# stack delete usually completes on the first pass. The retain fallback below covers
# the case where it has not finished in time.
if [ -n "$FLEET_ARN" ] && [ "$FLEET_ARN" != "None" ]; then
    echo "==> Deleting CodeBuild fleet up front (drains in parallel): $FLEET_ARN"
    aws codebuild delete-fleet --arn "$FLEET_ARN" 2>/dev/null \
        || echo "    (delete-fleet returned non-zero; it may already be deleting)"
else
    echo "==> No CodeBuild fleet found to pre-delete (already removed?)."
fi

# ---- Delete the stack ---------------------------------------------------------
echo "==> Deleting stack..."
aws cloudformation delete-stack --stack-name "$STACK_NAME"

echo "==> Waiting for delete..."
if aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" 2>/dev/null; then
    echo "==> Stack deleted on the first pass."
else
    STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
        --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo GONE)"
    if [ "$STATUS" = "GONE" ]; then
        echo "==> Stack is already gone."
    elif [ "$STATUS" = "DELETE_FAILED" ]; then
        echo "==> DELETE_FAILED (fleet not fully drained yet). Retrying, retaining the fleet..."
        if [ -n "$FLEET_LOGICAL_ID" ] && [ "$FLEET_LOGICAL_ID" != "None" ]; then
            aws cloudformation delete-stack \
                --stack-name "$STACK_NAME" \
                --retain-resources "$FLEET_LOGICAL_ID"
        else
            aws cloudformation delete-stack --stack-name "$STACK_NAME"
        fi
        aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
        echo "==> Stack deleted (fleet retained; it keeps draining out of band)."
    else
        echo "ERROR: unexpected stack status: $STATUS" >&2
        exit 1
    fi
fi

# ---- Out-of-band artifact purge (opt-in: --purge-artifacts) -------------------
# These are NOT tracked by CloudFormation, so a stack delete leaves them behind.
if [ "$PURGE_ARTIFACTS" -eq 1 ]; then
    echo "==> Purging out-of-band artifacts CloudFormation does not track..."

    # 1) Attested AMIs registered by CodeBuild + their backing EBS snapshots.
    #    STRICTLY scoped to the kiwi image name prefix so unrelated AMIs (e.g. other
    #    projects in a shared account) are never touched.
    echo "    - AMIs named ${AMI_NAME_PREFIX}* and their snapshots"
    AMI_IDS="$(aws ec2 describe-images --owners self \
        --filters "Name=name,Values=${AMI_NAME_PREFIX}*" \
        --query "Images[].ImageId" --output text 2>/dev/null || true)"
    for ami in $AMI_IDS; do
        [ -z "$ami" ] && continue
        SNAPS="$(aws ec2 describe-images --image-ids "$ami" \
            --query "Images[].BlockDeviceMappings[].Ebs.SnapshotId" --output text 2>/dev/null || true)"
        echo "      deregister $ami"
        aws ec2 deregister-image --image-id "$ami" 2>/dev/null || echo "        (deregister failed)"
        for s in $SNAPS; do
            if [ -z "$s" ] || [ "$s" = "None" ]; then continue; fi
            echo "      delete snapshot $s"
            aws ec2 delete-snapshot --snapshot-id "$s" 2>/dev/null || echo "        (snapshot in use / already gone)"
        done
    done

    # 2) Runtime-written model SSM params (the model-workflow Lambda writes these; they
    #    are not CloudFormation-managed). /boltz/models/latest IS CFN-managed and already
    #    removed with the stack; delete-parameter is idempotent, so this is safe.
    echo "    - SSM parameters under /boltz/models"
    MODEL_PARAMS="$(aws ssm get-parameters-by-path --path /boltz/models --recursive \
        --query "Parameters[].Name" --output text 2>/dev/null || true)"
    for p in $MODEL_PARAMS; do
        [ -z "$p" ] && continue
        echo "      delete param $p"
        aws ssm delete-parameter --name "$p" 2>/dev/null || true
    done

    echo "==> Artifact purge complete."
    echo "    NOTE: the KMS keys (alias/boltz-model-key, alias/boltz-sequence-key) are"
    echo "    SCHEDULED for deletion (their aliases are freed on stack delete, so a"
    echo "    redeploy recreates them cleanly). They are not billed while pending and"
    echo "    disappear after the deletion window; no action is needed."
fi

echo "==> Cleanup complete."
