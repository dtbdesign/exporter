import express from 'express';
import runFigmaExport from './export.js';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;

app.post('/run', async (req, res) => {
  const auth = req.headers['authorization'];
  if (process.env.RUN_SECRET && auth !== `Bearer ${process.env.RUN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const urls = await runFigmaExport();
    res.json({ success: true, urls });
  } catch (err) {
    console.error('❌ Error running export:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Figma Export Server is live!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});