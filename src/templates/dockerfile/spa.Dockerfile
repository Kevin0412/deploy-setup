FROM node:{{NODE_VERSION}}-alpine AS builder

WORKDIR /app

{{#IF MIRROR_ALPINE}}
RUN sed -i 's/dl-cdn.alpinelinux.org/{{MIRROR_ALPINE}}/g' /etc/apk/repositories
{{/IF}}
{{#IF MIRROR_NPM}}
RUN echo "registry=https://{{MIRROR_NPM}}" > /root/.npmrc
{{/IF}}

COPY package*.json .npmrc* ./
{{#IF NEEDS_BUILD_TOOLS}}
RUN apk add --no-cache python3 make g++
{{/IF}}
RUN npm ci --legacy-peer-deps && npm cache clean --force

COPY . .
RUN {{BUILD_CMD}}

FROM nginx:1.30.1-alpine AS production

{{#IF MIRROR_ALPINE}}
RUN sed -i 's/dl-cdn.alpinelinux.org/{{MIRROR_ALPINE}}/g' /etc/apk/repositories
{{/IF}}

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
