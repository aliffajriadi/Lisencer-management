'use strict';

require('dotenv').config();
const app = require('./app');
const { logger } = require('./lib/logger');

const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  logger.info(`Lucifer License System running on http://localhost:${PORT}`);
});
