#!/bin/bash
# Package the AMI build source and upload to S3 to trigger the CodePipeline.
# Usage: ./scripts/package-and-upload.sh [bucket-name]
#
# The uploaded source/source.zip is consumed by the "kiwi overlay" CodeBuild
# project, which runs packaging-kiwi-ng/scripts/build.sh (kiwi-ng system build)
# and upload-ami.sh (coldsnap + register-image) to produce an attested AMI.
#
# It packages:
#   - app/                  (backend source baked into the AMI overlay)
#   - packaging-kiwi-ng/     (kiwi descriptions, overlay, build/upload scripts)
#
# The build profile (ZOA 'prod' vs 'foa') is NOT set here. It is a build-time
# configuration read by CodeBuild from the /boltz-attestation/build-profile SSM
# parameter (default 'prod'). To build the FOA dev/test AMI instead, run:
#   aws ssm put-parameter --name /boltz-attestation/build-profile --value foa --overwrite
# before triggering the build (and set it back to 'prod' afterwards).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CDK_OUTPUTS="$PROJECT_ROOT/cdk/cdk-outputs.json"
STACK_NAME="${STACK_NAME:-BoltzAttestationStack}"
AMI_ID_PARAM="/boltz-attestation/ami-id"

# ---- Resolve bucket name (arg -> cdk outputs -> SSM -> CloudFormation) --------
if [ -n "$1" ]; then
    BUCKET_NAME="$1"
else
    if [ -f "$CDK_OUTPUTS" ]; then
        echo "Reading bucket name from cdk/cdk-outputs.json..."
        BUCKET_NAME=$(grep -o '"SourceBucketName": *"[^"]*"' "$CDK_OUTPUTS" | head -1 | sed 's/.*": *"//;s/"//')
    fi
    if [ -z "$BUCKET_NAME" ]; then
        echo "Fetching bucket name from CloudFormation stack outputs..."
        BUCKET_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
            --query "Stacks[0].Outputs[?OutputKey=='SourceBucketName'].OutputValue" --output text 2>/dev/null || echo "")
    fi
fi

if [ -z "$BUCKET_NAME" ]; then
    echo "ERROR: Could not determine bucket name."
    echo "Usage: $0 [bucket-name]"
    echo "Or deploy CDK first: cd cdk && npx cdk deploy $STACK_NAME --outputs-file cdk-outputs.json"
    exit 1
fi

echo "========================================"
echo "Packaging Boltz AMI Build Source"
echo "========================================"
echo "Target bucket: $BUCKET_NAME"

TEMP_DIR=$(mktemp -d)
ZIP_FILE="$TEMP_DIR/source.zip"

cd "$PROJECT_ROOT"

echo "Creating source package..."
# App source (baked into the AMI overlay by build.sh)
# Only the backend under app/ is baked into the AMI. (The React UI lives in the
# repo-root frontend/ and is hosted on Amplify; the legacy app/frontend was removed.)
zip -r "$ZIP_FILE" app/ \
    -x "*.pyc" \
    -x "*__pycache__*" \
    -x "*/node_modules/*"

# kiwi-ng packaging (descriptions, overlay, build + upload scripts)
zip -ur "$ZIP_FILE" packaging-kiwi-ng/ \
    -x "packaging-kiwi-ng/output/*" \
    -x "packaging-kiwi-ng/overlay/opt/boltz/app/*" \
    -x "packaging-kiwi-ng/kiwi/overlay.tar.gz" \
    -x "*.log"

echo ""
echo "Package contents (first 50 entries):"
unzip -l "$ZIP_FILE" | head -50

echo ""
echo "Uploading to S3..."
aws s3 cp "$ZIP_FILE" "s3://$BUCKET_NAME/source/source.zip"

rm -rf "$TEMP_DIR"

echo ""
echo "========================================"
echo "Upload Complete!"
echo "========================================"
echo "Source uploaded to: s3://$BUCKET_NAME/source/source.zip"
echo ""
echo "CodePipeline (boltz-attestation-pipeline) will be triggered automatically."
echo "It will: build the attested AMI (kiwi-ng) -> register it -> update SSM"
echo "         parameter $AMI_ID_PARAM -> roll the ASG via instance refresh."
echo ""
echo "Monitor:"
echo "  - Pipeline: https://console.aws.amazon.com/codesuite/codepipeline/pipelines/boltz-attestation-pipeline"
echo "  - Build:    aws codebuild list-builds-for-project --project-name boltz-attestation-ami-builder"
echo ""
