# Tilawa's native Qur'an speech engine: whisper.cpp (MIT, github.com/ggml-org/whisper.cpp) with a small JNI layer.
# whisper.cpp is fetched at a pinned release (tag and commit checked below) when the project is first configured.
cmake_minimum_required(VERSION 3.22)
project(tilawa_whisper C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Always optimised, also in debug builds of the app: a debug ggml is many times slower.
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
set(CMAKE_C_FLAGS_DEBUG "-O3 -DNDEBUG")
set(CMAKE_CXX_FLAGS_DEBUG "-O3 -DNDEBUG")

set(WHISPER_TAG v1.9.5)
set(WHISPER_COMMIT d1be6fde11ac6e0407606b4e42fe72d34add8037)

include(FetchContent)
# one copy of the sources for all ABIs (each ABI configures its own build tree)
if (NOT FETCHCONTENT_BASE_DIR OR FETCHCONTENT_BASE_DIR MATCHES "_deps$")
    set(FETCHCONTENT_BASE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../build/whisper-src-${WHISPER_TAG} CACHE PATH "" FORCE)
endif()
FetchContent_Declare(whisper
    GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
    GIT_TAG        ${WHISPER_TAG}
    GIT_SHALLOW    TRUE
    GIT_PROGRESS   FALSE)
FetchContent_GetProperties(whisper)
if (NOT whisper_POPULATED)
    FetchContent_Populate(whisper)
endif()
execute_process(COMMAND git rev-parse HEAD WORKING_DIRECTORY ${whisper_SOURCE_DIR} OUTPUT_VARIABLE got OUTPUT_STRIP_TRAILING_WHITESPACE)
if (NOT got STREQUAL WHISPER_COMMIT)
    message(FATAL_ERROR "whisper.cpp ${WHISPER_TAG} is at ${got}, expected ${WHISPER_COMMIT}")
endif()

set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)  # ggml's own thread pool: nothing extra to ship
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE ON CACHE BOOL "" FORCE)

if (ANDROID_ABI STREQUAL "arm64-v8a" OR ANDROID_ABI STREQUAL "x86_64")
    # CPUs differ in what they can do (ARM: dot product, fp16 arithmetic, int8 matrix multiply, SVE; x86: AVX2,
    # AVX-512...): one CPU backend is built per feature set, and at run time ggml loads the best one this device can
    # run (tw_load). x86_64 is only for emulators (debug builds).
    set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
    set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
    set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
else ()
    # armeabi-v7a: one build with NEON (on by default in the NDK)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
endif ()

# every library next to the app's own (Android Studio packages what lands there); the CPU backends go to the
# runtime output directory
if (CMAKE_LIBRARY_OUTPUT_DIRECTORY)
    set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_LIBRARY_OUTPUT_DIRECTORY})
endif ()
add_subdirectory(${whisper_SOURCE_DIR} whisper)

add_library(tilawa_whisper SHARED tw.cpp jni.cpp)
target_link_libraries(tilawa_whisper PRIVATE whisper ggml log)
target_compile_options(tilawa_whisper PRIVATE -O3 -fvisibility=hidden -ffunction-sections -fdata-sections)
target_link_options(tilawa_whisper PRIVATE -Wl,--gc-sections)
