CXX ?= c++
CC ?= cc
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra
CFLAGS ?= -O2 -std=c11 -Wall -Wextra

# Prism Secure's crypto core is the proven C11 implementation (same sources as
# the C port), compiled as C and wrapped by prism_secure.hpp.
prism: prism.o prism_crypto.o prism_ecdsa.o prism_secure.o prism_secure_wrap.o cli.o
	$(CXX) $(CXXFLAGS) -o $@ $^ -lz

prism.o: prism.cpp prism.hpp
	$(CXX) $(CXXFLAGS) -c prism.cpp

prism_crypto.o: prism_crypto.c prism_crypto.h
	$(CC) $(CFLAGS) -c prism_crypto.c

prism_ecdsa.o: prism_ecdsa.c prism_crypto.h
	$(CC) $(CFLAGS) -c prism_ecdsa.c

prism_secure.o: prism_secure.c prism_secure.h prism_crypto.h
	$(CC) $(CFLAGS) -c prism_secure.c

prism_secure_wrap.o: prism_secure_wrap.cpp prism_secure.hpp prism.hpp prism_secure.h
	$(CXX) $(CXXFLAGS) -c prism_secure_wrap.cpp

cli.o: cli.cpp prism.hpp prism_secure.hpp
	$(CXX) $(CXXFLAGS) -c cli.cpp

clean:
	rm -f prism *.o

.PHONY: clean
