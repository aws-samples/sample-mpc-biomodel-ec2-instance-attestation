# Boltz Protein Folding Frontend

React-based frontend for secure protein structure prediction with AWS NitroTPM hardware attestation.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    AWS Amplify                             │
│  ┌──────────────────────────────────────────────────────┐ │
│  │              React + TypeScript Frontend              │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │ │
│  │  │ Biologist   │  │ Biophysicist│  │ KMS Policy  │  │ │
│  │  │ Dashboard   │  │ Dashboard   │  │ Editor      │  │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  │ │
│  └──────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼───────────────────┐
         │                    │                   │
         ▼                    ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  AWS Cognito    │  │   EC2 Backend   │  │    AWS KMS      │
│  (Auth)         │  │   (NitroTPM)    │  │  (Encryption)   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Features

### Two User Roles

| Role | Description | KMS Key |
|------|-------------|---------|
| **Computational Biologist** | Protein structure prediction | `alias/boltz-sequence-key` |
| **Computational Biophysicist** | Model weight deployment | `alias/boltz-model-key` |

### Security Features

- 🔐 **End-to-end encryption** - Sequences encrypted with AWS KMS
- 🛡️ **PCR attestation** - Data only decryptable on verified EC2 instances
- 🔑 **KMS key policy management** - Add PCR conditions directly from UI
- 👤 **Cognito authentication** - Restricted to @amazon.com emails

## Quick Start

### Prerequisites

- Node.js 18+
- npm 9+
- AWS CLI configured with credentials
- Cognito User Pool (run `../scripts/setup-cognito.sh`)

### Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your values:
# - VITE_COGNITO_USER_POOL_ID
# - VITE_COGNITO_CLIENT_ID
# - VITE_COGNITO_IDENTITY_POOL_ID
# - VITE_BACKEND_URL

# Start development server
npm run dev
```

The app will be available at http://localhost:5173

### Production Build

```bash
npm run build
# Output in dist/
```

### Deploy to Amplify

```bash
# From project root
../scripts/deploy-frontend.sh --env prod --region us-east-1
```

## Project Structure

```
frontend/
├── src/
│   ├── components/
│   │   ├── auth/              # Cognito authentication
│   │   │   ├── AuthProvider.tsx
│   │   │   ├── LoginPage.tsx
│   │   │   └── ProtectedRoute.tsx
│   │   ├── roles/             # Role-specific views
│   │   │   ├── RoleSelector.tsx
│   │   │   ├── BiologistDashboard.tsx
│   │   │   └── BiophysicistDashboard.tsx
│   │   ├── attestation/       # Backend verification
│   │   │   └── BackendConnection.tsx
│   │   ├── kms/               # KMS policy management
│   │   │   └── KMSPolicyEditor.tsx
│   │   ├── sequences/         # Sequence management
│   │   │   └── SequenceLibrary.tsx
│   │   └── predictions/       # Job management
│   │       └── JobHistory.tsx
│   ├── contexts/
│   │   └── RoleContext.tsx    # Role state management
│   ├── services/
│   │   └── kms.ts             # KMS API client
│   ├── types/
│   │   └── index.ts           # TypeScript types
│   ├── App.tsx                # Main app with routing
│   └── main.tsx               # Entry point
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `VITE_AWS_REGION` | AWS region | Yes |
| `VITE_COGNITO_USER_POOL_ID` | Cognito User Pool ID | Yes |
| `VITE_COGNITO_CLIENT_ID` | Cognito App Client ID | Yes |
| `VITE_COGNITO_IDENTITY_POOL_ID` | Cognito Identity Pool ID | Yes |
| `VITE_COGNITO_DOMAIN` | Cognito hosted UI domain | Yes |
| `VITE_BACKEND_URL` | EC2 backend URL | Yes |
| `VITE_S3_BUCKET` | S3 bucket for encrypted data | Optional |
| `VITE_SSM_TRUST_STORE_PATH` | SSM parameter path | Optional |

## User Flow

### Computational Biologist Workflow

1. **Login** → Cognito authentication
2. **Select Role** → Choose "Computational Biologist"
3. **Connect Backend** → Enter EC2 URL, verify attestation
4. **Review PCRs** → Check PCR values from attestation document
5. **Configure KMS** → Add PCR conditions to key policy
6. **Add Sequence** → Input or upload protein sequence
7. **Encrypt & Store** → KMS encryption, S3 upload
8. **Submit Job** → Send encrypted sequence to backend
9. **Monitor Progress** → Poll for job status
10. **Download Results** → Get PDB structure

### Computational Biophysicist Workflow

1. **Login** → Cognito authentication
2. **Select Role** → Choose "Computational Biophysicist"
3. **Connect Backend** → Enter EC2 URL, verify attestation
4. **Review PCRs** → Check PCR values from attestation document
5. **Configure KMS** → Add PCR conditions to model key policy
6. **Upload Weights** → Select model weights file
7. **Encrypt & Upload** → KMS encryption, S3 upload
8. **Deploy Model** → Trigger deployment on backend
9. **Monitor Deployment** → Check deployment status
10. **Verify Activation** → Confirm new model is active

## KMS Key Policy Management

The KMS Policy Editor allows users to add PCR conditions to their KMS keys:

```json
{
  "Sid": "AllowDecryptWithAttestation",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::ACCOUNT:role/BoltzEC2Role" },
  "Action": "kms:Decrypt",
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "kms:RecipientAttestation:NitroTPMPCR0": "...",
      "kms:RecipientAttestation:NitroTPMPCR4": "...",
      "kms:RecipientAttestation:NitroTPMPCR7": "...",
      "kms:RecipientAttestation:NitroTPMPCR16": "..."
    }
  }
}
```

## Development

### Available Scripts

```bash
npm run dev      # Start development server
npm run build    # Production build
npm run lint     # Run ESLint
npm run preview  # Preview production build
npm run test     # Run tests
```

### Technology Stack

- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Tailwind CSS** - Styling
- **AWS Amplify** - Auth & hosting
- **AWS SDK v3** - KMS, S3, SSM clients

## Deployment

### Current Deployment

| Resource | Value |
|----------|-------|
| URL | https://main.d181lajk9fhkab.amplifyapp.com |
| Amplify App ID | d181lajk9fhkab |
| Cognito User Pool | us-east-1_3MjM4AqHL |
| Region | us-east-1 |

### Update Deployment

```bash
# Make changes, then redeploy
../scripts/deploy-frontend.sh --env prod --region us-east-1
```

## Troubleshooting

### Build Errors

```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
npm run build
```

### Cognito Issues

- Ensure callback URLs include your Amplify domain
- Check that identity pool trusts the user pool
- Verify IAM role has necessary permissions

### KMS Policy Errors

- Ensure the identity pool role has `kms:GetKeyPolicy` and `kms:PutKeyPolicy`
- Check that the KMS key exists and you have access
- Verify the key alias format: `alias/your-key-name`

## Related Documentation

- [Main README](../README.md)
- [Backend API](../app/README.md)
- [Packaging](../packaging-kiwi-ng/README.md)
- [Changes Log](../app_changes.md)