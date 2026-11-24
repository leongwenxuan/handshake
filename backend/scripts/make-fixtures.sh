#!/bin/sh
# Generates synthetic self-introductions with macOS `say`, as 16 kHz mono WAV,
# plus a copy of each with crowd-like noise mixed in. Replace or add real
# recordings in backend/fixtures/ for more honest numbers.
set -e
cd "$(dirname "$0")/../fixtures"
make() { # name, voice, text
  say -v "$2" -o "/tmp/hs-$1.aiff" "$3"
  ffmpeg -loglevel error -y -i "/tmp/hs-$1.aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$1.wav"
  ffmpeg -loglevel error -y -i "$1.wav" -f lavfi -i "anoisesrc=color=pink:amplitude=0.06:sample_rate=16000" \
    -filter_complex "[0][1]amix=inputs=2:duration=first:normalize=0" -ar 16000 -ac 1 -c:a pcm_s16le "$1-noisy.wav"
  rm "/tmp/hs-$1.aiff"
}
make sarah-stripe Samantha "Hi, I'm Sarah Chen, I run partnerships at Stripe."
make raj-startup Daniel "Hey, I'm Raj Patel. I'm a founder at Lumio, we do inventory software for cafes."
make priya-ramp Moira "Hi, I'm Priya Nair, I lead engineering at Ramp."
make tom-agency Fred "Hey, Tom Becker. I run a small marketing agency, we do social media for local brands."
make karri-linear Daniel "Hi, I'm Karri Saarinen, I'm the CEO at Linear."
make patrick-stripe Moira "Hey, Patrick Collison. I'm one of the founders of Stripe."
make mia-student Karen "Hi! I'm Mia, I'm a student at NYU, just here to learn."
ls -la
