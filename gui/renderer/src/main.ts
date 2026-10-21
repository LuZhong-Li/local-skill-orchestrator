import { createApp } from 'vue';
import App from './App.vue';
import { i18n } from './i18n/index.ts';
import { initializeLanguage } from './i18n/language.ts';
import './styles.css';

async function bootstrap(): Promise<void> {
  await initializeLanguage();
  createApp(App).use(i18n).mount('#app');
}

void bootstrap();
