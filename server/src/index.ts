import "dotenv/config";
import { initializeTables } from './db';
import { createApp } from './app';

async function startServer() {
  // Initialize database tables
  await initializeTables();

  const PORT = process.env.PORT || 3000;
  createApp().listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Start the server and handle any errors
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
}); 
