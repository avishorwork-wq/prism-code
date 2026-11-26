CXX ?= c++
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra

prism: prism.o cli.o
	$(CXX) $(CXXFLAGS) -o $@ prism.o cli.o -lz

prism.o: prism.cpp prism.hpp
	$(CXX) $(CXXFLAGS) -c prism.cpp

cli.o: cli.cpp prism.hpp
	$(CXX) $(CXXFLAGS) -c cli.cpp

clean:
	rm -f prism prism.o cli.o

.PHONY: clean
