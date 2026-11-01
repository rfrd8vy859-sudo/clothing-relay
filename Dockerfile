FROM node:20
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV DATA_FILE=/data/data.json
EXPOSE 80
CMD ["node", "server.js"]
