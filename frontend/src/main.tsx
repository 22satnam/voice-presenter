import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Load fonts at runtime so the single-file bundle stays self-contained
const fontLink = document.createElement('link')
fontLink.rel = 'stylesheet'
fontLink.href = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500&display=swap'
document.head.appendChild(fontLink)
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

