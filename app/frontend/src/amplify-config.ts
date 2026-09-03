/**
 * AWS Amplify Configuration
 * 
 * This file contains the configuration for AWS Amplify services:
 * - Cognito for authentication
 * - S3 for storage
 * - SSM access via API Gateway (for trust store)
 * 
 * These values should be populated during deployment via environment variables
 * or by the setup-cognito.sh script.
 */

const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
      identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID || '',
      loginWith: {
        email: true,
      },
      signUpVerificationMethod: 'code' as const,
      userAttributes: {
        email: {
          required: true,
        },
      },
      passwordFormat: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireNumbers: true,
        requireSpecialCharacters: true,
      },
    },
  },
  Storage: {
    S3: {
      bucket: import.meta.env.VITE_S3_BUCKET || '',
      region: import.meta.env.VITE_AWS_REGION || 'us-east-1',
    },
  },
}

export default amplifyConfig
