import { test } from '@playwright/test';
import { coreCases } from './core-cases';

// Same cases on WebKit (the engine behind WKWebView / Tauri on macOS).
test.use({ browserName: 'webkit' });
coreCases();
