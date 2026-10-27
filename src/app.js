'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const contractRoutes = require('./routes/contracts');
const signRoutes = require('./routes/sign');
const adminRoutes = require('./routes/admin');
const { authLimiter, generalLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const config = require('./config/env');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === new URL(config.clientUrl).origin) return callback(null, true);
    const error = new Error('Origin is not allowed by CORS');
    error.status = 403;
    return callback(error);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(generalLimiter);

const health = (req, res) => res.json({ status: 'ok', service: 'contracts-zar-api', timestamp: new Date().toISOString() });
app.get('/health', health);
app.get('/api/health', health);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/sign', signRoutes);
app.use('/api/admin', adminRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
