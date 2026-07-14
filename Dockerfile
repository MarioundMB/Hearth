FROM node:20-alpine

RUN apk add --no-cache nginx nginx-mod-stream git docker-cli docker-compose openssl curl socat util-linux \
 && git config --global --add safe.directory /app/repo \
 && curl https://get.acme.sh | sh 2>/dev/null || true

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
RUN mkdir -p /etc/nginx/hearth-proxy /etc/nginx/hearth-certs/_default \
             /etc/nginx/hearth-auth /etc/nginx/hearth-streams /var/log/nginx /run/nginx /var/www/acme

ENV PORT=4500
ENV PROXY_PORT=443
ENV HTTP_PORT=80
EXPOSE 4500 80 443

CMD ["node", "server.js"]
