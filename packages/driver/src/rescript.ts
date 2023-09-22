import { ArrayCodec } from "./codecs/array";
import { NullCodec } from "./codecs/codecs";
import { AT_LEAST_ONE, AT_MOST_ONE, MANY, ONE } from "./codecs/consts";
import { EnumCodec } from "./codecs/enum";
import { ICodec, ScalarCodec } from "./codecs/ifaces";
import { NamedTupleCodec } from "./codecs/namedtuple";
import { Int16Codec, Int32Codec } from "./codecs/numbers";
import { BigIntCodec } from "./codecs/numerics";
import { ObjectCodec } from "./codecs/object";
import { RangeCodec } from "./codecs/range";
import { SetCodec } from "./codecs/set";
import { TupleCodec } from "./codecs/tuple";
import { Cardinality } from "./ifaces";

const polyVariantNameNeedsEscapingRegex = /^[a-zA-Z0-9_]+$/;

interface Ctx {
  optionalNulls: boolean;
  distinctTypes: Set<string>;
  currentPath: string[];

  // Dummies just to keep diffs in the fork clean
  indent: string;
  imports: Set<string>;
}

function capitalizeStr(str: string): string {
  return `${str[0].toLowerCase()}${str.slice(1)}`;
}

function pathToName(path: string[]) {
  const name = path.join("_");

  // Make valid ReScript record name.
  return capitalizeStr(name);
}

export function generateSetTypeRescript(
  type: string,
  cardinality: Cardinality
): string {
  switch (cardinality) {
    case Cardinality.AT_LEAST_ONE:
    case Cardinality.MANY:
      return `array<${type}>`;
    case Cardinality.ONE:
      return type;
    case Cardinality.AT_MOST_ONE:
      return `Js.Nullable.t<${type}>`;
  }
  throw Error(`unexpected cardinality: ${cardinality}`);
}

function generateRecord(
  fields: {
    name: string;
    cardinality: number;
  }[],
  subCodecs: ICodec[],
  ctx: Ctx
) {
  const name = pathToName(ctx.currentPath);
  const recordDef = `  type ${name} = {\n${fields
    .map((field, i) => {
      let subCodec = subCodecs[i];
      if (subCodec instanceof SetCodec) {
        if (
          !(field.cardinality === MANY || field.cardinality === AT_LEAST_ONE)
        ) {
          throw Error("subcodec is SetCodec, but upper cardinality is one");
        }
        subCodec = subCodec.getSubcodecs()[0];
      }
      return `    ${/* TODO: @as() for invalid names*/ field.name}${
        ctx.optionalNulls && field.cardinality === AT_MOST_ONE ? "?" : ""
      }: ${generateSetTypeRescript(
        walkCodecRescript(subCodec, {
          ...ctx,
          currentPath: [...ctx.currentPath, field.name],
        }),
        field.cardinality
      )},`;
    })
    .join("\n")}\n  }`;

  ctx.distinctTypes.add(recordDef);

  return name;
}

export function walkCodecRescript(codec: ICodec, ctx: Ctx): string {
  if (codec instanceof NullCodec) {
    return "Js.Nullable.null";
  }
  if (codec instanceof ScalarCodec) {
    if (codec instanceof EnumCodec) {
      return `[${codec.values
        .map((v) => {
          const name = polyVariantNameNeedsEscapingRegex.test(v) ? v : `"${v}"`;
          return `#${name}`;
        })
        .join(" | ")}]`;
    }
    if (codec instanceof Int16Codec || codec instanceof Int32Codec) {
      return "int";
    }
    if (codec instanceof BigIntCodec) {
      return "bigint";
    }
    if (codec.tsType === "number") {
      return "float";
    }
    if (codec.tsType === "boolean") {
      return "bool";
    }
    return codec.tsType;
  }
  if (codec instanceof ObjectCodec || codec instanceof NamedTupleCodec) {
    const fields =
      codec instanceof ObjectCodec
        ? codec.getFields()
        : codec.getNames().map((name) => ({ name, cardinality: ONE }));
    const subCodecs = codec.getSubcodecs();
    return generateRecord(fields, subCodecs, ctx);
  }
  if (codec instanceof ArrayCodec) {
    return `array<${walkCodecRescript(codec.getSubcodecs()[0], ctx)}>`;
  }
  if (codec instanceof TupleCodec) {
    return `(${codec
      .getSubcodecs()
      .map((subCodec) => walkCodecRescript(subCodec, ctx))
      .join(", ")})`;
  }
  if (codec instanceof RangeCodec) {
    const subCodec = codec.getSubcodecs()[0];
    if (!(subCodec instanceof ScalarCodec)) {
      throw Error("expected range subtype to be scalar type");
    }
    // TODO: Can we pluck out ints etc here?
    return `Range.t<${subCodec.tsType}>`;
  }
  throw Error(`Unexpected codec kind: ${codec.getKind()}`);
}
