# File Research Inc.

We use the technology created by [Number Research Inc.](https://numberresearch.xyz/) to transmit digital files through the World Wide Web (WWW).

## Method

1. Choose a random 64-bit number as the file ID. We wouldn't want the numbers associated with our file data to conflict with any other already-discovered numbers. The file ID size can be easily increased or decreased by modifying the keygen function.
2. Shift this number to the left by 32 bits to allocate 4 gibibits of space for the file data. This new number will be referred to as the BASE.
3. If the current second mod 20 is greater than or equal to 10, write the 1 bits of the file at (BASE + i). Otherwise, write the 0 bits of the file at (BASE + i). i refers to the index of a given bit in the file. Continue until all bits have been written.
4. When reading a file back, request all of the numbers associated with the file sequentially and check their timestamps to derive the original bits.

End-of-file is indicated by a bit that was written more than 60 seconds after the previous bit, so make sure you don't lose your connection while uploading a large file!

## Future Research

We believe that it may be possible to open real-time Transmission Control Protocol (TCP) tunnels between different terminals using the `search_count` field in API responses.
