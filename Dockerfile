FROM node:20-alpine

# Nginx für den integrierten Reverse Proxy
RUN apk add --no-cache nginx

WORKDIR /app

# Abhängigkeiten zuerst (besseres Layer-Caching)
COPY package.json ./
RUN npm install --omit=dev

# Quellcode
COPY server.js ./
COPY public ./public

# Nginx-Basiskonfiguration
COPY nginx/nginx.conf /etc/nginx/nginx.conf
RUN mkdir -p /etc/nginx/hearth-proxy /var/log/nginx /run/nginx

ENV PORT=4500
ENV PROXY_PORT=80
EXPOSE 4500 80

CMD ["node", "server.js"]
