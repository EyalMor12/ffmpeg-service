FROM node:18-bullseye

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY cloudRunFFmpegService.js .

EXPOSE 8080
CMD ["node", "cloudRunFFmpegService.js"]