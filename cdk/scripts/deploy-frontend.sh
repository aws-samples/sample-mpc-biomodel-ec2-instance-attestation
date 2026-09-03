#!/bin/bash
# Build the React/Vite frontend and deploy it to the CDK-created AWS Amplify app.
# Usage: ./cdk/scripts/deploy-frontend.sh [stack-name] [aws-profile]
#
# This is the CDK-driven counterpart to scripts/deploy-frontend.sh: instead of
# creating its own Amplify app, it reads the Amplify App ID + Cognito/API config
# from the CDK outputs (cdk/cdk-outputs.json) produced by `npx cdk deploy`.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$CDK_DIR/.." && pwd)"
FRONTEND_DIR="$PROJECT_ROOT/app/frontend"
CDK_OUTPUTS_FILE="$CDK_DIR/cdk-outputs.json"

STACK_NAME="${1:-BoltzAttestationStack}"
AWS_PROFILE_NAME="${2:-${AWS_PROFILE:-}}"
BRANCH="main"

echo "========================================"
echo "Deploying Frontend to Amplify (CDK app)"
echo "========================================"

if [ ! -f "$CDK_OUTPUTS_FILE" ]; then
  echo "ERROR: CDK outputs file not found at: $CDK_OUTPUTS_FILE"
  echo "Run 'cd cdk && npx cdk deploy $STACK_NAME' first to generate outputs."
  exit 1
fi

echo "Reading outputs from: $CDK_OUTPUTS_FILE (stack: $STACK_NAME)"
APP_ID=$(jq -r ".[\"$STACK_NAME\"].AmplifyAppId // empty" "$CDK_OUTPUTS_FILE")
API_ENDPOINT=$(jq -r ".[\"$STACK_NAME\"].ApiEndpoint // empty" "$CDK_OUTPUTS_FILE")
USER_POOL_ID=$(jq -r ".[\"$STACK_NAME\"].UserPoolId // empty" "$CDK_OUTPUTS_FILE")
USER_POOL_CLIENT_ID=$(jq -r ".[\"$STACK_NAME\"].UserPoolClientId // empty" "$CDK_OUTPUTS_FILE")
IDENTITY_POOL_ID=$(jq -r ".[\"$STACK_NAME\"].IdentityPoolId // empty" "$CDK_OUTPUTS_FILE")
# Buckets are CDK auto-named; inject the real names so the UI doesn't rely on a fixed prefix.
SEQUENCES_BUCKET=$(jq -r ".[\"$STACK_NAME\"].SequencesBucketName // empty" "$CDK_OUTPUTS_FILE")
MODELS_BUCKET=$(jq -r ".[\"$STACK_NAME\"].ModelsBucketName // empty" "$CDK_OUTPUTS_FILE")

AWS_DEPLOY_REGION=$(echo "$API_ENDPOINT" | sed -n 's|.*execute-api\.\([^.]*\)\.amazonaws\.com.*|\1|p')
if [ -z "$AWS_DEPLOY_REGION" ]; then
  AWS_DEPLOY_REGION=$(echo "$USER_POOL_ID" | cut -d'_' -f1)
fi

if [ -z "$APP_ID" ]; then
  echo "ERROR: Could not find AmplifyAppId in CDK outputs for stack '$STACK_NAME'"
  echo "Available stacks:"; jq -r 'keys[]' "$CDK_OUTPUTS_FILE"
  exit 1
fi

# Allow env override of the backend endpoint
API_ENDPOINT="${VITE_BACKEND_URL:-$API_ENDPOINT}"

# Build optional CLI flags as an array so each element is passed as a distinct argv
# entry (avoids word-splitting an unquoted string).
AWS_FLAGS=()
[ -n "$AWS_DEPLOY_REGION" ] && AWS_FLAGS+=(--region "$AWS_DEPLOY_REGION")
[ -n "$AWS_PROFILE_NAME" ] && AWS_FLAGS+=(--profile "$AWS_PROFILE_NAME")

echo "  Region:              ${AWS_DEPLOY_REGION:-<default>}"
echo "  Amplify App ID:      $APP_ID"
echo "  API/Backend URL:     $API_ENDPOINT"
echo "  User Pool ID:        $USER_POOL_ID"
echo "  User Pool Client ID: $USER_POOL_CLIENT_ID"
echo "  Identity Pool ID:    $IDENTITY_POOL_ID"
echo "  Sequences bucket:    $SEQUENCES_BUCKET"
echo "  Models bucket:       $MODELS_BUCKET"
echo ""

echo "Building frontend..."
cd "$FRONTEND_DIR"
npm ci
VITE_BACKEND_URL="$API_ENDPOINT" \
VITE_COGNITO_USER_POOL_ID="$USER_POOL_ID" \
VITE_COGNITO_CLIENT_ID="$USER_POOL_CLIENT_ID" \
VITE_COGNITO_IDENTITY_POOL_ID="$IDENTITY_POOL_ID" \
VITE_AWS_REGION="$AWS_DEPLOY_REGION" \
VITE_SEQUENCES_BUCKET="$SEQUENCES_BUCKET" \
VITE_MODELS_BUCKET="$MODELS_BUCKET" \
npm run build

echo "Creating Amplify deployment..."
DEPLOYMENT=$(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" "${AWS_FLAGS[@]}" --output json)
JOB_ID=$(echo "$DEPLOYMENT" | jq -r '.jobId')
UPLOAD_URL=$(echo "$DEPLOYMENT" | jq -r '.zipUploadUrl')
echo "Job ID: $JOB_ID"

echo "Packaging and uploading..."
cd dist
zip -rq /tmp/boltz-frontend-deploy.zip .
curl -sS -X PUT -H "Content-Type: application/zip" -T /tmp/boltz-frontend-deploy.zip "$UPLOAD_URL"

echo "Starting deployment..."
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" "${AWS_FLAGS[@]}"

rm -f /tmp/boltz-frontend-deploy.zip

echo ""
echo "========================================"
echo "Deployment Started!"
echo "========================================"
echo "URL: https://$BRANCH.$APP_ID.amplifyapp.com"
echo "Monitor: aws amplify get-job --app-id $APP_ID --branch-name $BRANCH --job-id $JOB_ID"
