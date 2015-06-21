FROM debian:jessie

RUN echo "deb http://www.deb-multimedia.org jessie main non-free" >> /etc/apt/sources.list && apt-get -y update && apt-get -y --force-yes install deb-multimedia-keyring && apt-get -y update && apt-get -y install ffmpeg

ADD http://nodejs.org/dist/v0.12.4/node-v0.12.4-linux-x64.tar.gz /home/

RUN mkdir /nodejs && tar xvzf /home/node-v0.12.4-linux-x64.tar.gz -C /nodejs --strip-components=1 && rm /home/node-v0.12.4-linux-x64.tar.gz

ENV PATH $PATH:/nodejs/bin

WORKDIR /app
ADD package.json /app/
RUN npm install
ADD . /app

EXPOSE 80
EXPOSE 8080

CMD []
ENTRYPOINT ["/nodejs/bin/npm", "start"]
