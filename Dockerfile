FROM node:20-bullseye-slim

# Install system dependencies (including FFmpeg as a fallback)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency configs
COPY package*.json ./

# Install npm dependencies
RUN npm ci || npm install

# Copy everything else
COPY . .

# Build the frontend and compile the backend
RUN npm run build

# Start the Node.js server
CMD ["npm", "start"]
