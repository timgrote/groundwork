FROM node:20-slim

WORKDIR /app

# Copy package files first for better layer caching
COPY app/package*.json ./

# Install dependencies
RUN npm install

# Files will be mounted from host in dev mode
EXPOSE 3000

CMD ["npm", "run", "dev"]
