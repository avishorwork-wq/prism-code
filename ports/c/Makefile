CC ?= cc
CFLAGS ?= -O2 -std=c11 -Wall -Wextra

prism: prism.o prism_crypto.o prism_ecdsa.o prism_secure.o cli.o
	$(CC) $(CFLAGS) -o $@ $^ -lz -lm

prism.o: prism.c prism.h
	$(CC) $(CFLAGS) -c prism.c

prism_crypto.o: prism_crypto.c prism_crypto.h
	$(CC) $(CFLAGS) -c prism_crypto.c

prism_ecdsa.o: prism_ecdsa.c prism_crypto.h
	$(CC) $(CFLAGS) -c prism_ecdsa.c

prism_secure.o: prism_secure.c prism_secure.h prism_crypto.h
	$(CC) $(CFLAGS) -c prism_secure.c

cli.o: cli.c prism.h prism_secure.h
	$(CC) $(CFLAGS) -c cli.c

clean:
	rm -f prism *.o

.PHONY: clean
