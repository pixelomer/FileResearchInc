# File Research Inc.

We use the technology created by [Number Research Inc.](https://numberresearch.xyz/) to transmit digital files through the World Wide Web (WWW).

## Usage

```bash
# Upload a file
./upload.ts /path/to/input.bin

# Download a file (FILE_KEY is a hexadecimal 64-bit number by default, printed by upload.ts)
./download.ts FILE_KEY /path/to/output.bin
```

## Method

1. Choose a random 64-bit number as the file ID. We wouldn't want the numbers associated with our file data to conflict with any other already-discovered numbers. The file ID size can be easily increased or decreased by modifying the keygen function.
2. Shift this number to the left by 32 bits to allocate 2 gibibytes of space for the file data. This new number is called the BASE. Each nibble of the file will be written to (BASE + i), where i is the index of the nibble.
3. Uniformly distribute the seconds in a day into windows for each hexadecimal digit (0, 1, 2, ...up to F). Within each window, only discover the numbers corresponding to nibbles that match the nibble of this window. Repeat until all nibbles have been written. (For example, if each nibble window is 20 seconds, and if the current time is 00:01:22, then the current nibble would be 4. Between 00:01:20 - 00:01:40, only the nibbles with a value of 4 should be written.)
5. When reading a file back, request all of the numbers associated with the file sequentially and check their timestamps to derive the original nibbles.

After the upload is completed, the number before the first nibble is used to mark the final timestamp of the file. While downloading, this timestamp is checked to ensure that no nibbles past the end of the file are written to disk.

## Future Research

We believe that it may be possible to open real-time Transmission Control Protocol (TCP) tunnels between different terminals using the `search_count` field in API responses.
