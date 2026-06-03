FROM node:20-alpine

RUN apk add --no-cache nginx git docker-cli docker-compose \
 && git config --global --add safe.directory /app/repo

ARG GIT_SHA=unknown
ENV HEARTH_SHA=${GIT_SHA}

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
