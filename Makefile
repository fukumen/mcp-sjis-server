.PHONY: all install build start clean

all: install build

install:
	npm install

build:
	npm run build

start:
	npm start

clean:
	rm -rf dist node_modules
