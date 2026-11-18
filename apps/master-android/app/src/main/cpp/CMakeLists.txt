cmake_minimum_required(VERSION 3.22.1)
project(ravennode)

# libnode.so (nodejs-mobile) is copied into src/main/jniLibs/<abi>/ by scripts/android.mjs.
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

add_library(ravennode SHARED native-lib.cpp)
target_include_directories(ravennode PRIVATE ${NODE_INCLUDE})
find_library(log-lib log)
target_link_libraries(ravennode libnode ${log-lib})
