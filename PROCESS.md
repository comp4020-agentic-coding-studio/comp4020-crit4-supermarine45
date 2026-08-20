# Process overview

## What I built

The idea is to build an interactive musical “looping tool” in the style of Apple's GarageBand, that allows users to create, remix, and layer music through a range of interactive methods. Alongside traditional keyboard-based interaction, the prototype allows users to incorporate voice recordings, drum beats, and other pre-made audio, including samples, re-sampled from freely licensed sources. The goal is to create a tool that encourages experimentation and user creativity while maintaining a simple, accessible interface, unlike the complex traditional synthesizers.

## The moments that mattered

1. **what happened** 
The initial idea proposed by the agents (Claude and Gemini) was to create a “constellation styled interface” in which users could interact with the space by drawing, with their actions producing different sounds:

> The interface combines a 4-track looping drum machine, a generative "Constellation" note looper in the center canvas, and a live playable Piano UI at the bottom to jam over the loops.

However, this approach was insufficient because the concept was too abstract and lacked a clear direction.

2. **what you did instead of the obvious thing** 
Rather than continuing to iterate on the agent’s initial concept, I took greater control over defining the requirements and desired functionality of the prototype. This led to several pivots in the design as I progressively refined the concept and clarified what I wanted the final tool to achieve:

> I want to make the following additions: 1. add a complete scale of piano as well as an option, 2. allow layering of the loop at different tempos, 3. allow to add the loop using the keyboard. Any other ideas?

> Next, I want to put the recorded beats and piano playing into different sections of the music. Utilize a drag-and-drop interface in the UI so I can slide over and apply the loop when I want to. I want to make it easy to have multiple layers of music. The idea is to have a more comprehensive implementation of 'Garage Band' or 'Loopy HD'.

3. **how you knew it was right** 
I knew the prototype was heading in the right direction once it implemented all of the core functionality I had specified ([`0aac693`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-supermarine45/commit/0aac693f6baf76e9bc4286493323b482a73937c7)). I then thoroughly tested and reviewed the prototype to verify that these features worked as intended and that the overall interaction aligned with the intended experience.

1. **what happened** 
Initially, I asked the agent to synthesise pre-made audio in several different styles. However, I observed the generated audio was broken or did not accurately capture the styles I was aiming for (i.e., wrong instruments):

> Next, add some ready-to-use background sound, similar to what we often see in digital piano. This should include a lot of pre-made background sounds and base. For instance, in the style of big band, swing, samba jazz, elevator music, etc.

2. **what you did instead of the obvious thing** 
Instead of prompting the agent to iteratively refine the generated audio, I decided to have it resample several freely licensed audio recordings from the internet:

> Can you extract the preloaded tracks like 'big band' and 'samba' from the internet? Surely there's some free-licensed jazz soundtrack on the web?

This produced significantly more realistic and usable audio, which could then be further processed to suit the user’s needs, such as adjusting the samples to match the BPM set by the user:

> Replace all the synthesized samples with a resampled version of the live samples. So just resample a small part of them to the correct beat adjusted in the bpm.
> ([`85cb780`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit4-supermarine45/commit/85cb7805273171521984b43c1db47a1c36a905e6))

3. **how you knew it was right** 
I checked on each resampled audio clip by ear to determine whether it matched the musical style and character I intended. This human-based evaluation allowed me to identify samples that felt appropriate and discard or refine those that did not fit the desired styles.