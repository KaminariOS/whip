module.exports = {
  dependency: {
    platforms: {
      // The first rollout is iOS-only. This module remains a separate package
      // so Android can be enabled after its generated CMake/JNI path is tested.
      android: null,
    },
  },
};
