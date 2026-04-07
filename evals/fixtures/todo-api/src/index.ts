// Express-style bootstrap. Mounts the auth and tasks routers.
// squint should detect the mounted routes and the entry point modules.

import { authController } from './controllers/auth.controller.js';
import { tasksController } from './controllers/tasks.controller.js';
import { createApp } from './framework.js';

const app = createApp();

app.use('/api/auth', authController.router);
app.use('/api/tasks', tasksController.router);

const PORT = 3000;
app.listen(PORT, () => {
  // Server started
});
