CXX ?= c++
CC ?= cc
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra
CFLAGS ?= -O2 -std=c11 -Wall -Wextra

# Prism Secure's crypto core is the proven C11 implementation (same sources as
# the C port), compiled as C and wrapped by prism_secure.hpp.
prism: prism.o prism_crypto.o prism_ecdsa.o prism_secure.o prism_secure_wrap.o prism_parts.o prism_cards.o prism_issuers.o prism_capacity_shim.o prism_parts_wrap.o prism_cards_wrap.o prism_issuers_wrap.o cli.o
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

prism_parts.o: prism_parts.c prism_parts.h prism.h prism_secure.h
	$(CC) $(CFLAGS) -c prism_parts.c

prism_cards.o: prism_cards.c prism_cards.h
	$(CC) $(CFLAGS) -c prism_cards.c

prism_issuers.o: prism_issuers.c prism_issuers.h prism_secure.h
	$(CC) $(CFLAGS) -c prism_issuers.c

prism_capacity_shim.o: prism_capacity_shim.cpp prism.hpp
	$(CXX) $(CXXFLAGS) -c prism_capacity_shim.cpp

prism_parts_wrap.o: prism_parts_wrap.cpp prism_parts.hpp prism.hpp prism_parts.h
	$(CXX) $(CXXFLAGS) -c prism_parts_wrap.cpp

prism_cards_wrap.o: prism_cards_wrap.cpp prism_cards.hpp prism.hpp prism_cards.h
	$(CXX) $(CXXFLAGS) -c prism_cards_wrap.cpp

prism_issuers_wrap.o: prism_issuers_wrap.cpp prism_issuers.hpp prism_issuers.h
	$(CXX) $(CXXFLAGS) -c prism_issuers_wrap.cpp

cli.o: cli.cpp prism.hpp prism_secure.hpp prism_parts.hpp prism_cards.hpp prism_issuers.hpp
	$(CXX) $(CXXFLAGS) -c cli.cpp

clean:
	rm -f prism *.o

.PHONY: clean
