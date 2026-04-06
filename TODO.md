# TODO

## Discord Image Attachments

- Add attachment support to NanoClaw host messaging so agents can send generated images to Discord.
- Extend the container MCP `send_message` tool to accept attachment paths in addition to text.
- Extend host IPC message handling to forward attachment metadata from container to channel implementations.
- Extend the channel interface so `sendMessage` can carry files, not just plain text.
- Implement Discord upload support with `channel.send({ content, files })`.
- Map container-local group paths like `/workspace/group/...` to the corresponding host group folder safely.
- Restrict attachment uploads to files inside the current group's workspace.
- Add tests for IPC attachment forwarding and Discord file upload behavior.
