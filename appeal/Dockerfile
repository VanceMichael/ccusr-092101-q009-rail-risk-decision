
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY . .

RUN npm run migrate
ENV PORT=8090 APPEAL_DATABASE_PATH=/data/appeal.sqlite3
EXPOSE 8090
CMD ["npm", "start"]
