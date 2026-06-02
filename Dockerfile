FROM node:20-alpine

WORKDIR /app

# Abhängigkeiten zuerst (besseres Layer-Caching)
COPY package.json ./
RUN npm install --omit=dev

# Quellcode
COPY server.js ./
COPY public ./public

ENV PORT=4500
EXPOSE 4500

CMD ["node", "server.js"]
