import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { loadBenda } from '@strokkur/benda-angular';

bootstrapApplication(App, {
  providers: [provideBrowserGlobalErrorListeners()],
})
  .then(() => loadBenda({ port: 4499, name: 'benda-demo' }))
  .catch((err) => console.error(err));
