/**
 * Logging utilities
 * Note: In production, only errors and critical info are logged
 */

const isDevelopment = process.env.NODE_ENV === 'development';

export const logger = {
  log: (...args: any[]) => {
    // Always log in development, production only for important messages
    if (isDevelopment) {
      console.log(...args);
    }
  },

  warn: (...args: any[]) => {
    // Warnings always shown
    console.warn(...args);
  },

  error: (...args: any[]) => {
    // Errors always shown
    console.error(...args);
  },

  debug: (...args: any[]) => {
    if (isDevelopment) {
      console.debug(...args);
    }
  },

  info: (...args: any[]) => {
    // Info always shown (useful for debugging in production)
    console.info(...args);
  }
};

export default logger;