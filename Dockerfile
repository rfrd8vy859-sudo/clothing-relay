FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=80
ENV DATA_FILE=/data/data.json
RUN mkdir -p /data
EXPOSE 80
CMD ["node", "server.js"]
