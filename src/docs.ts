import express, { type Express } from 'express';
import swaggerUiDist from 'swagger-ui-dist';
import { buildOpenApi } from './openapi';

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Amplify API docs</title>
  <link rel="stylesheet" href="/docs/assets/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/assets/swagger-ui-bundle.js"></script>
  <script src="/docs/init.js"></script>
</body>
</html>`;

// Interactive documentation. Assets are served from this server and the init script is a separate file,
// so the strict Content-Security-Policy from helmet stays on.
export function mountDocs(app: Express) {
  const spec = buildOpenApi();
  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  app.get('/docs', (_req, res) => {
    res.type('html').send(PAGE);
  });
  app.get('/docs/init.js', (_req, res) => {
    res.type('js').send("window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });");
  });
  app.use('/docs/assets', express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false }));
}
