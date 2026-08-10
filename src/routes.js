export async function registerRoutes(app) {
  app.get('/health', async () => ({ status: 'ok' }));
}
