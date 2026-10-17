import { test } from '@playwright/test';
import { coreCases, widgetCases } from './core-cases';

// Same cases on WebKit (the engine behind WKWebView / Tauri on macOS).
test.use({ browserName: 'webkit' });
coreCases();
widgetCases();
