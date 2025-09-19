FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Expose port
EXPOSE 8000

# Set environment variables (will be overridden by App Service)
ENV NODE_ENV=production
ENV PORT=8000

# Start the application
CMD ["npm", "start"]