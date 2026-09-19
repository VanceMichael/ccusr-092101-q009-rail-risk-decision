
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./

COPY . .

RUN npm run migrate
ENV PORT=8080 DATABASE_PATH=/data/app.sqlite3
EXPOSE 8080
CMD ["npm", "start"]
