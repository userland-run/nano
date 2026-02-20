/* Minimal linker script for RISC-V Linux userland ELF */
ENTRY(_start)

SECTIONS
{
    /* Load at a reasonable virtual address */
    . = 0x10000;

    .text : {
        *(.text)
    }

    .rodata : {
        *(.rodata)
    }

    .data : {
        *(.data)
    }

    .bss : {
        *(.bss)
    }
}
