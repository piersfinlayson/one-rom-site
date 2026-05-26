## Background

Historically, ROMs have come in two types:

- Mask programmed ROMs - Programmed once at factory.
- EPROMs - Eraseable (via UV) Programmable Read-Only Memory.

The mask programmed ROMs have not been produced for decades, and both NOS and used mask programmed ROMs are now rare and expensive.

Larger size EPROMs are still widely available, primarily being pulled from old equipment, erased, often remarked (making them appear to be new, from another manufacturer, with different properties, or all of the above) and sold on sites like aliexpress and ebay.

Mask programmed ROMs have an additional complexity.  As well as the image being programmed at factory, often the behaviour of some of the chips, known as chip select lines, was also programmed at factory.

To replace mask programmed ROMs, EPROMs have often been used.  These often required additional circuitry to be added to the EPROM (either bodged on directly or via an adapter board).  These EPROMs also often have a larger data capacity than the original ROM, meaning "padding" or "duplicating" the original data when writing it to an EPROM.

Similarly, to replace EPROMs, larger capacity EPROMs, EEPROMs or flash chips have been used, against sometimes with additional circuitry, and with the same requirement of "padding" or "duplicating" the original data when writing it to a larger capacity chip.

## Identifying ROMs

Mask programmed ROMs were normally identified by their part number beginning with "23", such as 2316, 2364, 23512.  The digits after the 23 indicate the size of the ROM in Kbits, so a 2316 is a 2Kbit ROM, a 2364 is an 8Kbit ROM and a 23512 is a 64Kbit ROM.  However, while retro systems often have 23 series mask programmed ROMs installed, they are often identified, not by 23xx, but by a manufacturer specific part number, identifying both the type of chip AND its content and chip select behaviour.  For example, a Commodore 64 kernal on a mask programmed 2364 ROM might be identified as 901227-03.

In addition, some manufacturers chose to give their generic mask programmed ROMs by different part numbers, so a 2316 might also be known as 9316.

EPROMs normally begin with "27" in their part number, may then have one or two letters, followed by digits.  The letters typically indicate other properties.  For 24 and 28 pin EPROMs the digits indicate the size of the ROM in Kbits, so a 2764 is an 8Kbit EPROM, a 27128 is a 16Kbit EPROM and a 27256 is a 32Kbit EPROM.  However, for 32 pin and larger EPROMs, while still indicating the size of the ROM, the exact meaning of the digits is more complex.

EPROMs starting with 25 were also available and typically used different address pin and chip select behaviour than their 27 series counterparts.

For completeness, EEPROMs (Electrically Erasable Programmable Read-Only Memory) normally begin with "28" in their part number.  Flash EEPROMs normally begin with "29" or "39" in their part number.

## Why One ROM is Different

Unlike existing replacements that tend to shoe-horn in EPROMs or more modern chips, One ROM is designed to emulate **the exact type of ROM that your system expects**.  This means you don't need add additional circuitry or to "pad" the data when writing it to the chip.

This can sometimes lead to confusion as many users, and many of the instructions online for specific systems, assume a larger, EPROM, is being used.

For example, a Williams System 7 pinball machine was originally designed to take a 2332 mask programmed ROM.  However, for easier later upgradeability, 2532 and then 2732 (and then larger) EPROMs were sometimes used as replacements.  The 2532 is a drop in replacement for a 2332 (assuming the 2332 had a compatible chip select combination programmed, which for system 7 it did), but the 2732 requires adapting.  Due to the prevalence of the 2532 and 2732 as replacements people may think that the original ROM was a 2532 or 2732.  For system 7, One ROM should be configured to emulate the original 2332, with the correct chip select behaviour (CS1 = active low, CS2 = active high).

Where systems originally used 27 series EPROMs is is straightforward to configure One ROM to emulate the same type (and size) of EPROM as the original.

However, when a system originally used mask programmed ROMs, as in the example above, it can be more difficult to find out what ROM type the original expected.  A table is provided below showing the common mask programmed settins for various systems.  Bear in mind that different PCBs and revisions of the same system often cam with different ROM types.

As examples:
- Some Commodore 64s used separate 2364 mask programmed ROMs for the BASIC and kernal ROMs, whereas later ones, used a single combined 23128 BASIC+kernal ROM.
- The Atari 520ST came with either 6 x 32KB mask programmed ROMs (23256) **or** 2 x 128KB mask programmed ROMs (231024).  There were 

