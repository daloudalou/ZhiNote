# 枝记 ZhiNote — 纯静态应用，nginx 直接托管 PWA 目录即可
FROM nginx:alpine

COPY dist/web/ /usr/share/nginx/html/

EXPOSE 80
