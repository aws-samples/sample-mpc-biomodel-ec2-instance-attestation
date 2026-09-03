import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import '@aws-amplify/ui-react/styles.css'

import { AuthProvider } from './components/auth/AuthProvider'
import { RoleProvider, useRole } from './contexts/RoleContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { ConnectionProvider, useConnection } from './contexts/ConnectionContext'
import { ProtectedRoute } from './components/auth/ProtectedRoute'
import { LoginPage } from './components/auth/LoginPage'
import { RoleSelector } from './components/roles/RoleSelector'
import { BiologistDashboard, BiologistHome } from './components/roles/BiologistDashboard'
import { BiophysicistDashboard, BiophysicistHome } from './components/roles/BiophysicistDashboard'
import { BackendConnection } from './components/attestation/BackendConnection'
import { JobHistory } from './components/predictions/JobHistory'
import { KMSPolicyEditor } from './components/kms/KMSPolicyEditor'
import { SequenceEncryption } from './components/sequences/SequenceEncryption'
import { ModelManager } from './components/models/ModelManager'

// Biologist sequences with encryption
function BiologistSequences() {
  return <SequenceEncryption />
}

// KMS editor wired to the live attestation from the Backend Connection tab, so PCR
// conditions can be added straight from the currently-verified backend.
function BiologistKMS() {
  const { state } = useConnection()
  return <KMSPolicyEditor attestation={state.attestation} />
}

function BiophysicistKMS() {
  const { state } = useConnection()
  return <KMSPolicyEditor attestation={state.attestation} />
}

// Role-based route component
function RoleBasedRedirect() {
  const { role, isRoleSelected } = useRole()
  
  if (!isRoleSelected) {
    return <RoleSelector />
  }
  
  // Redirect to appropriate dashboard
  if (role === 'biologist') {
    return <Navigate to="/biologist" replace />
  }
  
  return <Navigate to="/biophysicist" replace />
}

function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <RoleProvider>
            <ConnectionProvider>
            <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            
            {/* Role selection - protected */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <RoleBasedRedirect />
                </ProtectedRoute>
              }
            />
            
            {/* Biologist routes */}
            <Route
              path="/biologist"
              element={
                <ProtectedRoute>
                  <BiologistDashboard />
                </ProtectedRoute>
              }
            >
              <Route index element={<BiologistHome />} />
              <Route path="connect" element={<BackendConnection />} />
              <Route path="sequences" element={<BiologistSequences />} />
              <Route path="kms" element={<BiologistKMS />} />
              <Route path="jobs" element={<JobHistory />} />
            </Route>
            
            {/* Biophysicist routes */}
            <Route
              path="/biophysicist"
              element={
                <ProtectedRoute>
                  <BiophysicistDashboard />
                </ProtectedRoute>
              }
            >
              <Route index element={<BiophysicistHome />} />
              <Route path="connect" element={<BackendConnection />} />
              <Route path="models" element={<ModelManager mode="weights" />} />
              <Route path="kms" element={<BiophysicistKMS />} />
              <Route path="deployments" element={<ModelManager mode="deploy" />} />
            </Route>
            
              {/* Catch all - redirect to home */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </ConnectionProvider>
          </RoleProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}

export default App