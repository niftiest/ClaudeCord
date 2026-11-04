import { createRoot } from 'react-dom/client'
import { App } from './App'
import { api } from './api'
import { setModelPrices } from '../shared/models'
import { AppDialogHost } from './components/AppDialog'
import { TextMenuHost } from './components/TextMenu'
import './styles.css'
import { applyCachedTheme } from './theme'
import { loadClaudeModels } from './components/useClaudeModels'

applyCachedTheme()
void loadClaudeModels()

// Costs show from the first paint, so this comes before it. Main has its answer ready within a
// moment, or a second or two straight after Claude Code has updated.
void api.modelPrices().then(setModelPrices).catch(() => { /* the built-in prices stand */ }).finally(() => {
  createRoot(document.getElementById('root')!).render(<><App /><AppDialogHost /><TextMenuHost /></>)
})
