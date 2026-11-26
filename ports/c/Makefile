CC ?= cc
CFLAGS ?= -O2 -std=c11 -Wall -Wextra

prism: prism.o cli.o
	$(CC) $(CFLAGS) -o $@ prism.o cli.o -lz -lm

prism.o: prism.c prism.h
	$(CC) $(CFLAGS) -c prism.c

cli.o: cli.c prism.h
	$(CC) $(CFLAGS) -c cli.c

clean:
	rm -f prism prism.o cli.o

.PHONY: clean
