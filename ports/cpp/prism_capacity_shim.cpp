/* Bridges the C parts module to the C++ core's capacity function. */
#include "prism.hpp"
extern "C" int prism_capacity_payload(int size, int ecc, int mode) {
    return prism::capacityPayload(size, ecc, mode);
}
