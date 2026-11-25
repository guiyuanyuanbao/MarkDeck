import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import App from './App.vue'
import { router } from './router'
import { initTheme } from './theme'
import './styles.css'

// apply the persisted theme BEFORE first paint, or the default indigo
// tokens flash and stale data-theme attributes leak (user saw a black
// header because dark-theme tokens from an earlier session persisted)
initTheme()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')
