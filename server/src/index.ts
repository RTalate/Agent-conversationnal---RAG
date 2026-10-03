import "dotenv/config";
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { CsvError } from 'csv-parse';
import { query, initializeTables } from './db';
import { analyzeTable } from './tableAnalyzer';
import { processQuery } from './process-query';
import { importCsv } from './csv-import';
import { InvalidInputError, parseTableName } from './sql-safety';

async function startServer() {
  // Initialize database tables
  await initializeTables();

  const app = express();
  app.use(cors());
  const upload = multer({ dest: 'uploads/' });

  app.post('/upload-csv', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const tableName = parseTableName(req.body.tableName);

      // Uploading again under the same name replaces the table, but only if this application
      // created it: never drop a table that happens to share the name.
      const { rows: [existing] } = await query(
        `SELECT to_regclass($1::text) IS NOT NULL AS present,
                EXISTS (SELECT 1 FROM TABLE_SCHEMA WHERE table_name = $1::text) AS managed`,
        [tableName]
      );
      if (existing.present && !existing.managed) {
        return res.status(409).json({
          error: `A table named "${tableName}" already exists and was not created by this application. Choose another name.`
        });
      }

      const { columns, columnTypes } = await importCsv(req.file.path, tableName);

      // After successful upload, analyze the table and store the results
      const analysis = await analyzeTable(tableName);

      // Store the analysis in TABLE_SCHEMA
      await query(
        `UPDATE TABLE_SCHEMA
         SET analysis = $2, updated_at = CURRENT_TIMESTAMP
         WHERE table_name = $1`,
        [tableName, analysis]
      );

      res.json({
        message: 'CSV data successfully imported to database',
        tableName,
        columnCount: columns.length,
        columnTypes,
        analysis
      });
    } catch (error) {
      if (error instanceof InvalidInputError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof CsvError) {
        return res.status(400).json({ error: `Invalid CSV file: ${error.message}` });
      }
      console.error('Error processing CSV:', error);
      res.status(500).json({ error: 'Failed to process CSV file' });
    }
  });

  app.post('/query', express.json(), async (req, res) => {
    try {
      const message = req.body?.message;
      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'A non-empty "message" is required' });
      }

      // Process the query using our new function
      const result = await processQuery(message);

      res.json(result);
    } catch (error) {
      console.error('Error processing query:', error);
      res.status(500).json({ error: 'Failed to process query' });
    }
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Start the server and handle any errors
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
