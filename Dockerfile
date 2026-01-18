FROM node:20-slim

WORKDIR /app

# Install http-server globally
RUN npm install -g http-server

# Files will be mounted from host

EXPOSE 3000

CMD ["http-server", "-p", "3000"]
